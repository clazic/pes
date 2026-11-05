-- PES stage-1 design draft; not a product migration.
-- Source: docs/plan/stage-1-db.md section 3; detail: discussion/stage-1-db-codex.md.
-- Caller enables foreign_keys before executing this file. No connection PRAGMAs here.
-- SQLite/D1 candidate grammar: CREATE TABLE/INDEX, FK, CHECK, UNIQUE, partial UNIQUE.
-- D1 execution has NOT been verified. No triggers, FTS, ATTACH, or extensions.
-- *_versions are append-only through the future PES service, NOT SQL write protection.
-- This schema does not itself authenticate callers, enforce every transition, guarantee
-- exactly six stages at all instants, make fence monotonic, or atomically commit R2.
-- Added scope/discriminator columns make the condensed design's FK rules explicit.
-- Nullable bootstrap pointers are filled before the surrounding command commits.

CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL CHECK (length(display_name) > 0),
    auth_subject TEXT UNIQUE,
    disabled_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0)
);

CREATE TABLE actors (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN
        ('human','internal_ai','external_agent','browser_agent','system','legacy_unknown')),
    user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    runtime TEXT,
    provider TEXT,
    display_name TEXT NOT NULL,
    disabled_at INTEGER,
    CHECK (kind <> 'human' OR user_id IS NOT NULL),
    UNIQUE (id, kind),
    UNIQUE (id, user_id),
    UNIQUE (id, user_id, kind)
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE CHECK (length(slug) > 0),
    topic TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    owner_role TEXT NOT NULL DEFAULT 'owner' CHECK (owner_role = 'owner'),
    active_edition_id TEXT,
    status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','active','archived')),
    control_rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(control_rev) = 'integer' AND control_rev >= 0),
    current_policy_id TEXT,
    created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
    CHECK (status <> 'active' OR current_policy_id IS NOT NULL),
    UNIQUE (id, owner_user_id),
    FOREIGN KEY (id, owner_user_id, owner_role)
        REFERENCES project_members(project_id, user_id, role)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (id, active_edition_id)
        REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (id, current_policy_id)
        REFERENCES project_policy_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('owner','editor','reader')),
    PRIMARY KEY (project_id, user_id),
    UNIQUE (project_id, user_id, role)
);
CREATE UNIQUE INDEX one_project_owner ON project_members(project_id) WHERE role = 'owner';

CREATE TABLE project_references (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    -- Local pointer when the source project is present in this DB. NULL when only A moved.
    referenced_project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    -- Stable source identity that survives A-only export/import (source project UUID / instance).
    referenced_project_key TEXT NOT NULL,
    source_snapshot_id TEXT,
    -- Original snapshot identity, kept after the local snapshot row is explicitly released.
    source_snapshot_key TEXT,
    source_label TEXT NOT NULL,
    latest_snapshot_id TEXT,
    scope_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_json) AND json_type(scope_json) = 'array'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','source_missing','source_archived')),
    attached_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    attached_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    attached_at INTEGER NOT NULL DEFAULT 0 CHECK (attached_at >= 0),
    refreshed_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    CHECK (referenced_project_id IS NULL OR project_id <> referenced_project_id),
    CHECK (source_snapshot_id IS NULL OR referenced_project_id IS NOT NULL),
    CHECK (latest_snapshot_id IS NULL OR referenced_project_id IS NOT NULL),
    CHECK (status <> 'source_missing'
        OR (source_snapshot_id IS NULL AND latest_snapshot_id IS NULL)),
    UNIQUE (project_id, id),
    FOREIGN KEY (referenced_project_id, source_snapshot_id)
        REFERENCES snapshots(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (referenced_project_id, latest_snapshot_id)
        REFERENCES snapshots(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) >= 32),
    created_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    revoked_at INTEGER,
    CHECK (expires_at IS NULL OR expires_at > created_at),
    UNIQUE (project_id, id)
);

CREATE TABLE mutation_commits (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    edition_id TEXT,
    stage_id TEXT,
    round_id TEXT,
    run_id TEXT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    on_behalf_of_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    via TEXT NOT NULL CHECK (via IN ('web','cli','http','mcp','webmcp','import')),
    client_request_id TEXT NOT NULL CHECK (length(client_request_id) > 0),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    action TEXT NOT NULL,
    base_control_rev INTEGER CHECK (base_control_rev >= 0),
    -- Historical lease evidence, deliberately NOT FK to the replaceable current lease.
    lease_id TEXT,
    fence INTEGER CHECK (fence >= 1),
    -- Future D1 commands must make failed CAS/lease/policy conditions a SQL failure.
    guard_ok INTEGER NOT NULL DEFAULT 1 CHECK (guard_ok = 1),
    result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL DEFAULT 0,
    CHECK (stage_id IS NULL OR edition_id IS NOT NULL),
    CHECK (round_id IS NULL OR stage_id IS NOT NULL),
    UNIQUE (project_id, id),
    UNIQUE (project_id, actor_id, client_request_id),
    FOREIGN KEY (project_id, edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, edition_id, stage_id)
        REFERENCES stages(project_id, edition_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id, round_id)
        REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, run_id, actor_id)
        REFERENCES runs(project_id, id, actor_id) ON DELETE RESTRICT
);

CREATE TABLE project_policy_versions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    policy_rev INTEGER NOT NULL CHECK (typeof(policy_rev) = 'integer' AND policy_rev >= 1),
    -- Initialization explicitly allows Go, per confirmed stage-0 section 7-1.
    allow_opencode_go INTEGER NOT NULL DEFAULT 1 CHECK (allow_opencode_go IN (0,1)),
    mode_a_model TEXT NOT NULL DEFAULT 'opencode-go/deepseek-v4.1-flash'
        CHECK (mode_a_model LIKE 'opencode-go/%'),
    go_usage_stop_percent INTEGER NOT NULL DEFAULT 90
        CHECK (go_usage_stop_percent BETWEEN 50 AND 100),
    changed_by TEXT NOT NULL,
    changed_by_user_id TEXT NOT NULL,
    changed_by_kind TEXT NOT NULL DEFAULT 'human' CHECK (changed_by_kind = 'human'),
    reason TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, id),
    UNIQUE (project_id, policy_rev),
    FOREIGN KEY (project_id, changed_by_user_id)
        REFERENCES projects(id, owner_user_id) ON DELETE RESTRICT,
    FOREIGN KEY (changed_by, changed_by_user_id, changed_by_kind)
        REFERENCES actors(id, user_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE counters (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    namespace TEXT NOT NULL,
    next_no INTEGER NOT NULL CHECK (typeof(next_no) = 'integer' AND next_no >= 1),
    PRIMARY KEY (project_id, namespace)
);

CREATE TABLE editions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    edition_no INTEGER NOT NULL CHECK (typeof(edition_no) = 'integer' AND edition_no >= 1),
    parent_edition_id TEXT,
    base_snapshot_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','archived')),
    current_stage_id TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    CHECK (parent_edition_id IS NULL OR parent_edition_id <> id),
    UNIQUE (project_id, id),
    UNIQUE (project_id, edition_no),
    FOREIGN KEY (project_id, parent_edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, base_snapshot_id) REFERENCES snapshots(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, id, current_stage_id)
        REFERENCES stages(project_id, edition_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX one_active_edition ON editions(project_id) WHERE status = 'active';

CREATE TABLE stages (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    edition_id TEXT NOT NULL,
    key TEXT NOT NULL CHECK (key IN ('plan','research','analyze','write','verify','publish')),
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','asking','active','approved')),
    current_round_id TEXT,
    approved_snapshot_id TEXT,
    stale_since_event_seq INTEGER,
    settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    CHECK ((key = 'plan' AND ordinal = 1) OR (key = 'research' AND ordinal = 2)
        OR (key = 'analyze' AND ordinal = 3) OR (key = 'write' AND ordinal = 4)
        OR (key = 'verify' AND ordinal = 5) OR (key = 'publish' AND ordinal = 6)),
    CHECK (status <> 'approved' OR approved_snapshot_id IS NOT NULL OR stale_since_event_seq IS NOT NULL),
    UNIQUE (project_id, id),
    UNIQUE (project_id, edition_id, id),
    UNIQUE (edition_id, key),
    UNIQUE (edition_id, ordinal),
    FOREIGN KEY (project_id, edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, id, current_round_id)
        REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, id, approved_snapshot_id)
        REFERENCES snapshots(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stale_since_event_seq)
        REFERENCES events(project_id, event_seq) ON DELETE RESTRICT
);

CREATE TABLE rounds (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    edition_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    round_no INTEGER NOT NULL CHECK (typeof(round_no) = 'integer' AND round_no >= 1),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed')),
    base_snapshot_id TEXT,
    sealed_snapshot_id TEXT,
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    CHECK (state <> 'sealed' OR sealed_snapshot_id IS NOT NULL),
    UNIQUE (project_id, id),
    UNIQUE (project_id, stage_id, id),
    UNIQUE (stage_id, round_no),
    FOREIGN KEY (project_id, edition_id, stage_id)
        REFERENCES stages(project_id, edition_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, base_snapshot_id) REFERENCES snapshots(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, id, sealed_snapshot_id)
        REFERENCES snapshots(project_id, round_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX one_open_round ON rounds(stage_id) WHERE state = 'open';

CREATE TABLE blobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
    media_type TEXT NOT NULL,
    original_name TEXT,
    state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging','ready','quarantined')),
    created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    UNIQUE (project_id, id),
    UNIQUE (project_id, sha256, size)
);

CREATE TABLE snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    edition_id TEXT NOT NULL,
    stage_id TEXT,
    round_id TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('edition','stage','round')),
    manifest_blob_id TEXT NOT NULL,
    through_event_seq INTEGER,
    control_rev INTEGER NOT NULL CHECK (control_rev >= 0),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    CHECK ((scope = 'edition' AND stage_id IS NULL AND round_id IS NULL)
        OR (scope = 'stage' AND stage_id IS NOT NULL AND round_id IS NULL)
        OR (scope = 'round' AND stage_id IS NOT NULL AND round_id IS NOT NULL)),
    UNIQUE (project_id, id),
    UNIQUE (project_id, stage_id, id),
    UNIQUE (project_id, round_id, id),
    FOREIGN KEY (project_id, edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, edition_id, stage_id)
        REFERENCES stages(project_id, edition_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id, round_id)
        REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, manifest_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, through_event_seq) REFERENCES events(project_id, event_seq) ON DELETE RESTRICT
);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    human_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    origin TEXT NOT NULL CHECK (origin IN ('new','legacy')),
    assurance TEXT NOT NULL CHECK (assurance IN ('verified','legacy_unverified')),
    tx_id TEXT NOT NULL,
    note TEXT,
    CHECK ((origin = 'new' AND assurance = 'verified' AND actor_kind = 'human' AND human_user_id IS NOT NULL)
        OR (origin = 'legacy' AND assurance = 'legacy_unverified')),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, stage_id) REFERENCES stages(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id, snapshot_id)
        REFERENCES snapshots(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, actor_kind) REFERENCES actors(id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, human_user_id) REFERENCES actors(id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE objects (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    edition_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN
        ('artifact','source','question','answer','assumption','decision','thread','message','followup')),
    display_no INTEGER NOT NULL CHECK (typeof(display_no) = 'integer' AND display_no >= 1),
    current_version_id TEXT,
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    archived_at INTEGER,
    UNIQUE (project_id, id),
    UNIQUE (project_id, id, kind),
    UNIQUE (project_id, id, edition_id),
    UNIQUE (project_id, kind, display_no),
    FOREIGN KEY (project_id, edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, id, current_version_id)
        REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT
);

CREATE TABLE object_versions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (typeof(version_no) = 'integer' AND version_no >= 1),
    based_on_version_id TEXT,
    created_in_round_id TEXT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    run_id TEXT,
    tx_id TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    created_at INTEGER NOT NULL DEFAULT 0,
    CHECK (based_on_version_id IS NULL OR based_on_version_id <> id),
    UNIQUE (project_id, id),
    UNIQUE (project_id, object_id, id),
    UNIQUE (project_id, id, object_id, kind),
    UNIQUE (object_id, version_no),
    FOREIGN KEY (project_id, object_id, kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, based_on_version_id)
        REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, created_in_round_id) REFERENCES rounds(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, run_id, actor_id) REFERENCES runs(project_id, id, actor_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE round_contents (
    project_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    role TEXT NOT NULL CHECK (role IN ('result','question','answer','review','decision','assumption','message','note')),
    PRIMARY KEY (round_id, object_id),
    FOREIGN KEY (project_id, round_id) REFERENCES rounds(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, version_id)
        REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT
);

CREATE TABLE artifacts (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'artifact' CHECK (object_kind = 'artifact'),
    stage_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN
        ('rq','chapter','topic','issue','table','section','claim','report','review','note','schedule','insight','output')),
    origin_version_id TEXT,
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id) REFERENCES stages(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, origin_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE artifact_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'artifact' CHECK (object_kind = 'artifact'),
    title TEXT NOT NULL,
    question TEXT,
    summary TEXT NOT NULL DEFAULT '',
    body_md TEXT,
    body_blob_id TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
        ('new','deepen','revise','browser','done','removed','failed','draft','published','archived')),
    confidence TEXT CHECK (confidence IN ('high','medium','low')),
    stats TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stats)),
    conflicts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicts)),
    verify TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(verify)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (body_md IS NULL OR body_blob_id IS NULL),
    UNIQUE (project_id, version_id),
    UNIQUE (project_id, object_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES artifacts(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, body_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE artifact_components (
    project_id TEXT NOT NULL,
    parent_version_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    child_version_id TEXT NOT NULL,
    section_label TEXT,
    PRIMARY KEY (parent_version_id, position),
    CHECK (parent_version_id <> child_version_id),
    FOREIGN KEY (project_id, parent_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, child_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE version_relations (
    project_id TEXT NOT NULL,
    from_version_id TEXT NOT NULL,
    to_version_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('derived_from','supports','supersedes','reuses','related')),
    PRIMARY KEY (from_version_id, to_version_id, kind),
    CHECK (from_version_id <> to_version_id),
    FOREIGN KEY (project_id, from_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, to_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE sources (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'source' CHECK (object_kind = 'source'),
    kind TEXT NOT NULL CHECK (kind IN ('web','file','stat','law')),
    canonical_locator TEXT,
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT
);

CREATE TABLE source_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'source' CHECK (object_kind = 'source'),
    title TEXT NOT NULL,
    url TEXT,
    locator TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator)),
    retrieved_at INTEGER,
    method TEXT NOT NULL CHECK (method IN ('search','fetch','browser','kosis','law','vworld','import','unknown')),
    verification_state TEXT NOT NULL CHECK (verification_state IN ('unverified','verified','partial','unreachable','legacy_unknown')),
    quote TEXT,
    evidence_blob_id TEXT,
    verified_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    CHECK (verification_state <> 'unreachable' OR quote IS NULL),
    UNIQUE (project_id, version_id),
    UNIQUE (project_id, object_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES sources(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, evidence_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE citations (
    project_id TEXT NOT NULL,
    artifact_version_id TEXT NOT NULL,
    citation_no INTEGER NOT NULL CHECK (citation_no >= 1),
    source_version_id TEXT NOT NULL,
    quote TEXT,
    locator TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator)),
    PRIMARY KEY (artifact_version_id, citation_no),
    FOREIGN KEY (project_id, artifact_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, source_version_id) REFERENCES source_versions(project_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE file_policies (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    -- One current policy per stored blob. Role/version uses share it, so a role cannot be
    -- more permissive than the blob's deny.
    ai_access TEXT NOT NULL CHECK (ai_access IN ('allow','deny')),
    rev INTEGER NOT NULL DEFAULT 1 CHECK (typeof(rev) = 'integer' AND rev >= 1),
    changed_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    changed_at INTEGER NOT NULL DEFAULT 0 CHECK (changed_at >= 0),
    reason TEXT,
    tx_id TEXT NOT NULL,
    UNIQUE (project_id, id),
    UNIQUE (project_id, blob_id),
    UNIQUE (project_id, blob_id, id),
    FOREIGN KEY (project_id, blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE version_files (
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('attachment','image','source','rendered','manifest')),
    file_policy_id TEXT NOT NULL,
    PRIMARY KEY (version_id, blob_id, role),
    FOREIGN KEY (project_id, version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, blob_id, file_policy_id)
        REFERENCES file_policies(project_id, blob_id, id) ON DELETE RESTRICT
);

CREATE TABLE file_ai_access_versions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    file_policy_id TEXT NOT NULL,
    ai_access TEXT NOT NULL CHECK (ai_access IN ('allow','deny')),
    changed_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    changed_at INTEGER NOT NULL DEFAULT 0 CHECK (changed_at >= 0),
    reason TEXT,
    rev INTEGER NOT NULL CHECK (typeof(rev) = 'integer' AND rev >= 1),
    tx_id TEXT NOT NULL,
    UNIQUE (project_id, id),
    UNIQUE (project_id, file_policy_id, rev),
    FOREIGN KEY (project_id, file_policy_id) REFERENCES file_policies(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE file_extractions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    source_file_policy_id TEXT NOT NULL,
    source_format TEXT NOT NULL,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','ready','partial','failed','unsupported')),
    text_blob_id TEXT,
    text_file_policy_id TEXT,
    text_hash TEXT,
    page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
    table_count INTEGER CHECK (table_count IS NULL OR table_count >= 0),
    warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
    created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
    tx_id TEXT NOT NULL,
    CHECK (status NOT IN ('ready','partial')
        OR (text_blob_id IS NOT NULL AND text_file_policy_id IS NOT NULL)),
    CHECK (text_hash IS NULL OR length(text_hash) = 64),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, blob_id, source_file_policy_id)
        REFERENCES file_policies(project_id, blob_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, text_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, text_blob_id, text_file_policy_id)
        REFERENCES file_policies(project_id, blob_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE sync_links (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    device_id TEXT NOT NULL,
    link_kind TEXT NOT NULL DEFAULT 'bridge' CHECK (link_kind IN ('bridge','mcp')),
    credential_kind TEXT NOT NULL DEFAULT 'helper_device'
        CHECK (credential_kind IN ('human_device','helper_device')),
    helper_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
    last_seen_at INTEGER,
    last_cursor TEXT,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
    revoked_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    CHECK (credential_kind <> 'helper_device' OR helper_actor_id IS NOT NULL),
    UNIQUE (project_id, id),
    UNIQUE (project_id, device_id, link_kind)
);

CREATE TABLE sync_items (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('up','down')),
    version_id TEXT,
    blob_id TEXT,
    local_label TEXT NOT NULL,
    remote_hash TEXT,
    local_hash TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','synced','conflict','source_missing','skipped')),
    conflict_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(conflict_json) AND json_type(conflict_json) = 'object'),
    updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    tx_id TEXT NOT NULL,
    UNIQUE (project_id, id),
    UNIQUE (project_id, link_id, direction, local_label),
    FOREIGN KEY (project_id, link_id) REFERENCES sync_links(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    link_id TEXT,
    run_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','done','failed','cancelled')),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0),
    planned_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    summary TEXT,
    changed_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files_json) AND json_type(changed_files_json) = 'array'),
    updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
    rev INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rev) = 'integer' AND rev >= 0),
    tx_id TEXT NOT NULL,
    UNIQUE (project_id, id),
    UNIQUE (project_id, seq),
    FOREIGN KEY (project_id, link_id) REFERENCES sync_links(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE question_sets (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    round_id TEXT,
    purpose TEXT NOT NULL CHECK (purpose IN ('stage_start','review','resume')),
    form_key TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    previous_set_id TEXT,
    published_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, id),
    UNIQUE (stage_id, form_key, version_no),
    FOREIGN KEY (project_id, stage_id) REFERENCES stages(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id, round_id) REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, previous_set_id) REFERENCES question_sets(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE questions (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'question' CHECK (object_kind = 'question'),
    asked_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    intended_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    direction TEXT NOT NULL CHECK (direction IN ('agent_to_human','human_to_agent')),
    origin TEXT NOT NULL CHECK (origin IN ('bank','review','manual','import')),
    bank_key TEXT,
    original_version_id TEXT NOT NULL,
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    -- Question identity and first version are inserted in ONE transaction/batch.
    FOREIGN KEY (project_id, object_id, original_version_id)
        REFERENCES question_versions(project_id, object_id, version_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE question_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'question' CHECK (object_kind = 'question'),
    text TEXT NOT NULL CHECK (length(text) > 0),
    type TEXT NOT NULL CHECK (type IN ('single','multi','text','textarea','number','scale','file')),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('draft','open','deferred','merged','withdrawn','closed')),
    importance TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('high','normal','low')),
    required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
    allow_comment_as_answer INTEGER NOT NULL DEFAULT 1 CHECK (allow_comment_as_answer IN (0,1)),
    default_value TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(default_value)),
    options TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options) AND json_type(options) = 'array'),
    show_if TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(show_if)),
    help TEXT,
    defer_until INTEGER,
    merged_into_question_id TEXT,
    CHECK (state <> 'merged' OR merged_into_question_id IS NOT NULL),
    CHECK (merged_into_question_id IS NULL OR merged_into_question_id <> object_id),
    UNIQUE (project_id, version_id),
    UNIQUE (project_id, object_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES questions(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, merged_into_question_id) REFERENCES questions(project_id, object_id) ON DELETE RESTRICT
);

CREATE TABLE question_set_members (
    project_id TEXT NOT NULL,
    set_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    question_version_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (set_id, question_id),
    UNIQUE (set_id, position),
    FOREIGN KEY (project_id, set_id) REFERENCES question_sets(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, question_id, question_version_id)
        REFERENCES question_versions(project_id, object_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE submissions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    drafted_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    set_id TEXT,
    received_at INTEGER NOT NULL DEFAULT 0,
    via TEXT NOT NULL CHECK (via IN ('web','cli','http','mcp','webmcp','import')),
    raw_blob_id TEXT,
    tx_id TEXT NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, set_id) REFERENCES question_sets(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, raw_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE answers (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'answer' CHECK (object_kind = 'answer'),
    question_id TEXT NOT NULL,
    respondent_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    submission_id TEXT NOT NULL,
    UNIQUE (project_id, object_id),
    UNIQUE (project_id, object_id, question_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, question_id) REFERENCES questions(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, submission_id) REFERENCES submissions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE answer_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'answer' CHECK (object_kind = 'answer'),
    question_id TEXT NOT NULL,
    question_version_id TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','skipped','withdrawn')),
    used_default INTEGER CHECK (used_default IN (0,1)),
    supersedes_version_id TEXT,
    UNIQUE (project_id, version_id),
    UNIQUE (project_id, object_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, question_id) REFERENCES answers(project_id, object_id, question_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, question_id, question_version_id)
        REFERENCES question_versions(project_id, object_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, supersedes_version_id)
        REFERENCES answer_versions(project_id, object_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE assumptions (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'assumption' CHECK (object_kind = 'assumption'),
    proposed_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    target_object_id TEXT,
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_object_id) REFERENCES objects(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE assumption_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'assumption' CHECK (object_kind = 'assumption'),
    statement TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','rejected','revised')),
    assessment_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    assessed_at INTEGER,
    needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
    rationale TEXT NOT NULL DEFAULT '',
    replacement_version_id TEXT,
    CHECK (state = 'proposed' OR assessment_actor_id IS NOT NULL),
    UNIQUE (project_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES assumptions(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, replacement_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE decisions (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'decision' CHECK (object_kind = 'decision'),
    scope TEXT NOT NULL CHECK (scope IN ('project','edition')),
    originated_from_version_id TEXT,
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, originated_from_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE decision_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'decision' CHECK (object_kind = 'decision'),
    statement TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','adopted','superseded','revoked')),
    decided_by TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    rationale TEXT NOT NULL DEFAULT '',
    supersedes_decision_id TEXT,
    CHECK (state = 'proposed' OR decided_by IS NOT NULL),
    UNIQUE (project_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES decisions(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, supersedes_decision_id) REFERENCES decisions(project_id, object_id) ON DELETE RESTRICT
);

CREATE TABLE anchors (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    target_object_id TEXT NOT NULL,
    target_version_id TEXT NOT NULL,
    exact_quote TEXT NOT NULL CHECK (length(exact_quote) > 0),
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    text_format_version INTEGER NOT NULL DEFAULT 1 CHECK (text_format_version >= 1),
    start_cp INTEGER,
    end_cp INTEGER,
    supersedes_anchor_id TEXT,
    CHECK ((start_cp IS NULL AND end_cp IS NULL)
        OR (start_cp IS NOT NULL AND end_cp IS NOT NULL AND start_cp >= 0 AND end_cp >= start_cp)),
    UNIQUE (project_id, id),
    UNIQUE (project_id, id, target_object_id),
    UNIQUE (project_id, id, target_object_id, target_version_id),
    FOREIGN KEY (project_id, target_object_id, target_version_id)
        REFERENCES artifact_versions(project_id, object_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, supersedes_anchor_id) REFERENCES anchors(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE anchor_resolutions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    anchor_id TEXT NOT NULL,
    target_object_id TEXT NOT NULL,
    evaluated_version_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('exact','moved','ambiguous','lost')),
    start_cp INTEGER,
    end_cp INTEGER,
    method TEXT NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0,
    confirmed_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    CHECK ((status IN ('exact','moved') AND start_cp IS NOT NULL AND end_cp IS NOT NULL
            AND start_cp >= 0 AND end_cp >= start_cp)
        OR (status IN ('ambiguous','lost') AND start_cp IS NULL AND end_cp IS NULL)),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, anchor_id, target_object_id)
        REFERENCES anchors(project_id, id, target_object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_object_id, evaluated_version_id)
        REFERENCES artifact_versions(project_id, object_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE threads (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'thread' CHECK (object_kind = 'thread'),
    target_object_id TEXT NOT NULL,
    target_version_id TEXT,
    context_kind TEXT NOT NULL CHECK (context_kind IN ('annotation','question_comment','general')),
    anchor_id TEXT,
    CHECK (context_kind <> 'annotation' OR (target_version_id IS NOT NULL AND anchor_id IS NOT NULL)),
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_object_id) REFERENCES objects(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_object_id, target_version_id)
        REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, anchor_id, target_object_id, target_version_id)
        REFERENCES anchors(project_id, id, target_object_id, target_version_id) ON DELETE RESTRICT
);

CREATE TABLE thread_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'thread' CHECK (object_kind = 'thread'),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','archived')),
    resolved_by_message_version_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    UNIQUE (project_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES threads(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, resolved_by_message_version_id)
        REFERENCES message_versions(project_id, thread_id, version_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'message' CHECK (object_kind = 'message'),
    thread_id TEXT NOT NULL,
    reply_to TEXT,
    submission_id TEXT,
    CHECK (reply_to IS NULL OR reply_to <> object_id),
    UNIQUE (project_id, object_id),
    UNIQUE (project_id, object_id, thread_id),
    UNIQUE (project_id, thread_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, thread_id) REFERENCES threads(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, thread_id, reply_to) REFERENCES messages(project_id, thread_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, submission_id) REFERENCES submissions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE message_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'message' CHECK (object_kind = 'message'),
    thread_id TEXT NOT NULL,
    body_md TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('published','edited','withdrawn')),
    UNIQUE (project_id, version_id),
    UNIQUE (project_id, thread_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, thread_id) REFERENCES messages(project_id, object_id, thread_id) ON DELETE RESTRICT
);

CREATE TABLE followups (
    project_id TEXT NOT NULL,
    object_id TEXT PRIMARY KEY NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'followup' CHECK (object_kind = 'followup'),
    origin_thread_id TEXT,
    origin_message_version_id TEXT,
    origin_version_id TEXT,
    CHECK (origin_message_version_id IS NULL OR origin_thread_id IS NOT NULL),
    UNIQUE (project_id, object_id),
    FOREIGN KEY (project_id, object_id, object_kind) REFERENCES objects(project_id, id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, origin_thread_id) REFERENCES threads(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, origin_thread_id, origin_message_version_id)
        REFERENCES message_versions(project_id, thread_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, origin_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE followup_versions (
    project_id TEXT NOT NULL,
    version_id TEXT PRIMARY KEY NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL DEFAULT 'followup' CHECK (object_kind = 'followup'),
    kind TEXT NOT NULL CHECK (kind IN ('edit_text','next_round_task','reopen_stage','none')),
    state TEXT NOT NULL CHECK (state IN ('proposed','accepted','running','applied','deferred','rejected','cancelled')),
    description TEXT NOT NULL,
    target_stage_id TEXT,
    target_round_id TEXT,
    base_artifact_version_id TEXT,
    proposed_artifact_version_id TEXT,
    confirmed_by_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,
    applied_tx_id TEXT,
    result_version_id TEXT,
    CHECK (kind <> 'edit_text' OR base_artifact_version_id IS NOT NULL),
    CHECK (kind NOT IN ('next_round_task','reopen_stage') OR target_stage_id IS NOT NULL),
    CHECK (target_round_id IS NULL OR target_stage_id IS NOT NULL),
    CHECK (state <> 'applied' OR applied_tx_id IS NOT NULL),
    CHECK (state <> 'applied' OR kind <> 'edit_text' OR result_version_id IS NOT NULL),
    CHECK (state <> 'applied' OR kind <> 'reopen_stage' OR confirmed_by_actor_id IS NOT NULL),
    UNIQUE (project_id, version_id),
    FOREIGN KEY (project_id, version_id, object_id, object_kind)
        REFERENCES object_versions(project_id, id, object_id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES followups(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_stage_id) REFERENCES stages(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_stage_id, target_round_id)
        REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, base_artifact_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, proposed_artifact_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, result_version_id) REFERENCES artifact_versions(project_id, version_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, applied_tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE reflection_entries (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    source_version_id TEXT NOT NULL,
    target_round_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('applied','partial','rejected','deferred')),
    rationale TEXT NOT NULL,
    result_version_id TEXT,
    followup_id TEXT,
    applied_tx_id TEXT,
    supersedes_entry_id TEXT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    tx_id TEXT NOT NULL,
    CHECK (disposition NOT IN ('applied','partial')
        OR (applied_tx_id IS NOT NULL AND (result_version_id IS NOT NULL OR followup_id IS NOT NULL))),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, source_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, target_round_id) REFERENCES rounds(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, result_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, followup_id) REFERENCES followups(project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, applied_tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, supersedes_entry_id) REFERENCES reflection_entries(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    edition_id TEXT NOT NULL,
    stage_id TEXT,
    round_id TEXT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('A','B')),
    runtime TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('worker','reviewer')),
    status TEXT NOT NULL CHECK (status IN
        ('queued','running','waiting_human','blocked_usage','succeeded','failed','cancelled','interrupted')),
    -- Go usage/extra-usage blocks are not waiting_human. They release the lease and require
    -- a fresh C4/R1 readiness check plus a new claim before resuming.
    go_block_reason TEXT CHECK (go_block_reason IS NULL OR go_block_reason IN
        ('usage_limit','extra_usage_off','usage_unknown','manual_hold')),
    go_blocked_at INTEGER CHECK (go_blocked_at IS NULL OR go_blocked_at >= 0),
    go_block_reset_at INTEGER CHECK (go_block_reset_at IS NULL OR go_block_reset_at >= 0),
    retry_of TEXT,
    parent_run_id TEXT,
    external_session_ref TEXT,
    base_control_rev INTEGER NOT NULL CHECK (base_control_rev >= 0),
    context_snapshot_id TEXT,
    workflow_version TEXT NOT NULL DEFAULT 'draft-1',
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    started_at INTEGER,
    ended_at INTEGER,
    CHECK (round_id IS NULL OR stage_id IS NOT NULL),
    CHECK (mode <> 'A' OR (provider = 'opencode-go' AND model LIKE 'opencode-go/%')),
    CHECK (status <> 'blocked_usage'
        OR (go_block_reason IS NOT NULL AND go_blocked_at IS NOT NULL)),
    CHECK (go_block_reason IS NULL OR status = 'blocked_usage'),
    CHECK (go_blocked_at IS NULL OR go_block_reason IS NOT NULL),
    CHECK (go_block_reset_at IS NULL OR status = 'blocked_usage'),
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    CHECK (retry_of IS NULL OR retry_of <> id),
    UNIQUE (project_id, id),
    UNIQUE (project_id, id, actor_id),
    FOREIGN KEY (project_id, edition_id) REFERENCES editions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, edition_id, stage_id) REFERENCES stages(project_id, edition_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, stage_id, round_id) REFERENCES rounds(project_id, stage_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, retry_of) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, parent_run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, context_snapshot_id) REFERENCES snapshots(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE run_targets (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    base_version_id TEXT,
    base_rev INTEGER NOT NULL CHECK (base_rev >= 0),
    PRIMARY KEY (run_id, object_id),
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES objects(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, base_version_id) REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT
);

CREATE TABLE project_leases (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    lease_id TEXT NOT NULL UNIQUE,
    run_id TEXT,
    owner_actor_id TEXT,
    fence INTEGER NOT NULL CHECK (typeof(fence) = 'integer' AND fence >= 1),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','revoked')),
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK (acquired_at <= heartbeat_at AND heartbeat_at < expires_at),
    CHECK (state <> 'active' OR (run_id IS NOT NULL AND owner_actor_id IS NOT NULL)),
    FOREIGN KEY (owner_actor_id) REFERENCES actors(id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, run_id, owner_actor_id) REFERENCES runs(project_id, id, actor_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE run_input_receipts (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    input_version_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('seen','applied','ignored')),
    reason TEXT,
    applied_tx_id TEXT,
    CHECK (state <> 'applied' OR applied_tx_id IS NOT NULL),
    PRIMARY KEY (run_id, input_version_id),
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, input_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, applied_tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE events (
    event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    run_id TEXT,
    tx_id TEXT NOT NULL,
    tx_index INTEGER NOT NULL CHECK (tx_index >= 0),
    tx_size INTEGER NOT NULL CHECK (tx_size >= 1 AND tx_index < tx_size),
    type TEXT NOT NULL,
    object_id TEXT,
    before_rev INTEGER CHECK (before_rev >= 0),
    after_rev INTEGER CHECK (after_rev >= 0),
    before_version_id TEXT,
    after_version_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
    created_at INTEGER NOT NULL DEFAULT 0,
    CHECK ((before_version_id IS NULL AND after_version_id IS NULL) OR object_id IS NOT NULL),
    UNIQUE (project_id, event_seq),
    UNIQUE (tx_id, tx_index),
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, tx_id) REFERENCES mutation_commits(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id) REFERENCES objects(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, before_version_id) REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, object_id, after_version_id) REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT
);

CREATE TABLE outbound_dispatches (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    policy_version_id TEXT NOT NULL,
    manifest_blob_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    state TEXT NOT NULL CHECK (state IN
        ('prepared','authorized','sent','response','adopted','blocked','failed','unknown')),
    request_key TEXT NOT NULL,
    external_request_id TEXT CHECK (external_request_id IS NULL OR length(external_request_id) > 0),
    authorized_at INTEGER,
    sent_at INTEGER,
    response_blob_id TEXT,
    response_hash TEXT CHECK (response_hash IS NULL OR length(response_hash) = 64),
    response_at INTEGER,
    adopted_version_id TEXT,
    adopted_at INTEGER,
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    billing_source TEXT,
    allowance_json TEXT CHECK (allowance_json IS NULL OR json_valid(allowance_json)),
    cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
    unknown_at INTEGER,
    unknown_reason TEXT,
    CHECK (state <> 'response' OR response_hash IS NOT NULL),
    CHECK (state <> 'adopted' OR (response_hash IS NOT NULL AND adopted_version_id IS NOT NULL)),
    CHECK (state <> 'unknown' OR unknown_at IS NOT NULL),
    CHECK (adopted_at IS NULL OR adopted_version_id IS NOT NULL),
    UNIQUE (project_id, id),
    UNIQUE (project_id, run_id, request_key),
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, policy_version_id) REFERENCES project_policy_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, manifest_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, response_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, adopted_version_id) REFERENCES object_versions(project_id, id) ON DELETE RESTRICT
    -- Current-policy authorization and actual network destination are command checks.
);

CREATE TABLE db_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    database_instance_id TEXT NOT NULL,
    cursor_epoch INTEGER NOT NULL CHECK (cursor_epoch >= 1)
);

CREATE TABLE import_batches (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    source_fingerprint TEXT NOT NULL UNIQUE,
    source_schema TEXT NOT NULL,
    importer_version TEXT NOT NULL,
    source_manifest_blob_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staging','validated','activated','failed')),
    report_blob_id TEXT,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, source_manifest_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, report_blob_id) REFERENCES blobs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE legacy_mappings (
    project_id TEXT NOT NULL,
    import_batch_id TEXT NOT NULL,
    legacy_kind TEXT NOT NULL,
    legacy_scope TEXT NOT NULL,
    legacy_key TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    new_object_id TEXT,
    new_version_id TEXT,
    -- Informational identifier for non-object rows; validated by the importer.
    new_row_id TEXT,
    PRIMARY KEY (import_batch_id, legacy_kind, legacy_scope, legacy_key, content_hash),
    CHECK (new_version_id IS NULL OR new_object_id IS NOT NULL),
    CHECK (new_object_id IS NOT NULL OR new_row_id IS NOT NULL),
    FOREIGN KEY (project_id, import_batch_id) REFERENCES import_batches(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, new_object_id) REFERENCES objects(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, new_object_id, new_version_id) REFERENCES object_versions(project_id, object_id, id) ON DELETE RESTRICT
);

CREATE INDEX objects_by_scope ON objects(project_id, edition_id, kind, archived_at);
CREATE INDEX versions_by_round ON object_versions(project_id, created_in_round_id, object_id);
CREATE INDEX round_contents_by_position ON round_contents(project_id, round_id, position);
CREATE INDEX question_sets_by_round ON question_sets(project_id, stage_id, round_id, published_at);
CREATE INDEX answers_by_question ON answers(project_id, question_id, respondent_actor_id);
CREATE INDEX threads_by_target ON threads(project_id, target_object_id);
CREATE INDEX messages_by_thread ON messages(project_id, thread_id);
CREATE INDEX citations_by_source ON citations(project_id, source_version_id);
CREATE INDEX relations_by_target ON version_relations(project_id, to_version_id, kind);
CREATE INDEX runs_by_status ON runs(project_id, status);
CREATE INDEX receipts_by_state ON run_input_receipts(project_id, run_id, state);
CREATE INDEX events_by_project_seq ON events(project_id, event_seq);
CREATE INDEX events_by_run ON events(project_id, run_id, event_seq);

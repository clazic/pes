-- pes:foreign_keys=off
-- migration 002 (SEL-52 / stage 2 PR19): user-registered AI connections for the built-in runner (mode A).
-- Details: docs/plan/stage-2-db-guarantees.md 8.16, decision docs/plan/decisions/0019.
--
-- Applied by scripts/pes_core/db.ts migrate() inside one transaction, with foreign key enforcement switched
-- off for its duration (the first line above asks for that): the `runs` table is rebuilt to widen two CHECK
-- constraints, and SQLite cannot alter a CHECK in place. migrate() runs PRAGMA foreign_key_check before it
-- commits and rolls everything back if one row points nowhere. Nothing is dropped without being copied first,
-- and no existing row changes.

-- ---------------------------------------------------------------------------
-- new tables

CREATE TABLE ai_connections (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(name) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('subscription_api','openai_compatible','anthropic','google','custom')),
    request_format TEXT NOT NULL CHECK (request_format IN ('openai_compatible','anthropic','google')),
    base_url TEXT NOT NULL CHECK (length(base_url) > 0),
    billing TEXT NOT NULL CHECK (billing IN ('subscription','pay_per_use')),
    -- Where the secret lives (a key store reference). The secret itself is never a column.
    key_ref TEXT NOT NULL CHECK (length(key_ref) > 0),
    key_last4 TEXT NOT NULL CHECK (length(key_last4) BETWEEN 1 AND 4),
    key_storage TEXT NOT NULL CHECK (length(key_storage) > 0),
    key_set_at INTEGER NOT NULL CHECK (key_set_at >= 0),
    key_set_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    -- +1 on every change of the key or the address; confirmations and baselines made for an earlier value do not count
    credential_rev INTEGER NOT NULL DEFAULT 1 CHECK (typeof(credential_rev) = 'integer' AND credential_rev >= 1),
    -- subscription: stop line (percent of the human-entered limits) and the three token limits
    stop_percent INTEGER CHECK (stop_percent IS NULL OR stop_percent BETWEEN 50 AND 100),
    limit_five_hour_tokens INTEGER CHECK (limit_five_hour_tokens IS NULL OR limit_five_hour_tokens > 0),
    limit_weekly_tokens INTEGER CHECK (limit_weekly_tokens IS NULL OR limit_weekly_tokens > 0),
    limit_monthly_tokens INTEGER CHECK (limit_monthly_tokens IS NULL OR limit_monthly_tokens > 0),
    -- pay_per_use: the cost cap (micro-units of the currency)
    cost_cap_currency TEXT CHECK (cost_cap_currency IS NULL OR length(cost_cap_currency) > 0),
    cost_cap_micros INTEGER CHECK (cost_cap_micros IS NULL OR cost_cap_micros > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    removed_at INTEGER,
    CHECK (billing <> 'subscription' OR (stop_percent IS NOT NULL
        AND limit_five_hour_tokens IS NOT NULL
        AND limit_weekly_tokens IS NOT NULL
        AND limit_monthly_tokens IS NOT NULL)),
    CHECK (billing <> 'pay_per_use' OR (cost_cap_currency IS NOT NULL AND cost_cap_micros IS NOT NULL)),
    UNIQUE (id, owner_user_id)
);
CREATE INDEX ai_connections_by_owner ON ai_connections(owner_user_id, removed_at);

-- Price entries are append-only: a new entry never rewrites an old one; the newest entry of a model is current.
CREATE TABLE ai_connection_prices (
    id TEXT PRIMARY KEY NOT NULL,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    model TEXT NOT NULL CHECK (length(model) > 0),
    currency TEXT NOT NULL CHECK (length(currency) > 0),
    input_per_mtok_micros INTEGER NOT NULL CHECK (typeof(input_per_mtok_micros) = 'integer' AND input_per_mtok_micros >= 0),
    output_per_mtok_micros INTEGER NOT NULL CHECK (typeof(output_per_mtok_micros) = 'integer' AND output_per_mtok_micros >= 0),
    entered_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    entered_at INTEGER NOT NULL CHECK (entered_at >= 0)
);
CREATE INDEX ai_connection_prices_by_model ON ai_connection_prices(connection_id, model);

-- Which connection and model a project uses. Append-only; the newest row is the current choice.
CREATE TABLE project_ai_selections (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    model TEXT NOT NULL CHECK (length(model) > 0),
    selected_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    selected_at INTEGER NOT NULL CHECK (selected_at >= 0)
);
CREATE INDEX project_ai_selections_by_project ON project_ai_selections(project_id);

-- One row per built-in run: the connection, model and price/stop settings taken when the run was created.
CREATE TABLE ai_run_settings (
    run_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    model TEXT NOT NULL CHECK (length(model) > 0),
    request_format TEXT NOT NULL CHECK (request_format IN ('openai_compatible','anthropic','google')),
    billing TEXT NOT NULL CHECK (billing IN ('subscription','pay_per_use')),
    stop_percent INTEGER CHECK (stop_percent IS NULL OR stop_percent BETWEEN 50 AND 100),
    price_id TEXT REFERENCES ai_connection_prices(id) ON DELETE RESTRICT,
    price_currency TEXT,
    price_input_per_mtok_micros INTEGER,
    price_output_per_mtok_micros INTEGER,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (billing <> 'pay_per_use' OR price_id IS NOT NULL),
    FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX ai_run_settings_by_connection ON ai_run_settings(connection_id);

-- Subscription protection (a subscription connection is called only while both exist, see a_runtime/usage.ts):
--   * a person's confirmation that the account cannot be charged beyond its plan ("extra charge" is off): which
--     account, when, and until when. The newest row of a connection is the one in force.
--   * the account's usage baseline: the tokens the account had already used, as the person read them from the
--     provider, at a moment. It counts as usage in every window that still contains that moment.
-- Both are append-only.
CREATE TABLE ai_extra_charge_off_confirmations (
    id TEXT PRIMARY KEY NOT NULL,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
    confirmed_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    confirmed_at INTEGER NOT NULL CHECK (confirmed_at >= 0),
    valid_until INTEGER NOT NULL,
    -- the connection's credential_rev when this was confirmed
    credential_rev INTEGER NOT NULL CHECK (typeof(credential_rev) = 'integer' AND credential_rev >= 1),
    CHECK (valid_until > confirmed_at)
);
CREATE INDEX ai_extra_charge_off_confirmations_by_connection ON ai_extra_charge_off_confirmations(connection_id);

CREATE TABLE ai_usage_baselines (
    id TEXT PRIMARY KEY NOT NULL,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    used_tokens INTEGER NOT NULL CHECK (typeof(used_tokens) = 'integer' AND used_tokens >= 0),
    recorded_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
    -- the connection's credential_rev when this was recorded
    credential_rev INTEGER NOT NULL CHECK (typeof(credential_rev) = 'integer' AND credential_rev >= 1)
);
CREATE INDEX ai_usage_baselines_by_connection ON ai_usage_baselines(connection_id);

-- Single-use re-authentication codes. Only a hash is stored.
CREATE TABLE ai_reauth_codes (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
    issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    CHECK (expires_at > issued_at)
);

-- A human's note on an 'unknown' outbound dispatch: was it charged or not. The dispatch row itself stays as it was.
CREATE TABLE dispatch_resolutions (
    dispatch_id TEXT PRIMARY KEY NOT NULL REFERENCES outbound_dispatches(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    outcome TEXT NOT NULL CHECK (outcome IN ('not_charged','charged')),
    note TEXT,
    resolved_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    resolved_at INTEGER NOT NULL CHECK (resolved_at >= 0)
);

-- ---------------------------------------------------------------------------
-- runs: widen two CHECK constraints (12-step rebuild; every row is copied unchanged)
--   * go_block_reason also accepts 'cost_cap' (a pay-per-use cost cap stop)
--   * mode 'A' also accepts runtime 'pes_builtin' with any registered model id (the legacy Go pair still passes)

CREATE TABLE runs_new (
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
    -- Usage/cost blocks are not waiting_human. They release the lease and require
    -- a fresh readiness check plus a new claim before resuming.
    go_block_reason TEXT CHECK (go_block_reason IS NULL OR go_block_reason IN
        ('usage_limit','extra_usage_off','usage_unknown','manual_hold','cost_cap')),
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
    CHECK (mode <> 'A'
        OR (provider = 'opencode-go' AND model LIKE 'opencode-go/%')
        OR runtime = 'pes_builtin'),
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

INSERT INTO runs_new (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model,
        role, status, go_block_reason, go_blocked_at, go_block_reset_at, retry_of, parent_run_id,
        external_session_ref, base_control_rev, context_snapshot_id, workflow_version, usage_json,
        started_at, ended_at)
    SELECT id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model,
        role, status, go_block_reason, go_blocked_at, go_block_reset_at, retry_of, parent_run_id,
        external_session_ref, base_control_rev, context_snapshot_id, workflow_version, usage_json,
        started_at, ended_at
    FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_status ON runs(project_id, status);

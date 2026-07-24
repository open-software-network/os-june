-- June-owned scheduled routine state.  This intentionally does not reuse the
-- retired Hermes cron schema: schedules, grants, and executions are now owned
-- by the desktop database and linked to June agent sessions/runs.
CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY NOT NULL,
    legacy_job_id TEXT UNIQUE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    repeat TEXT NOT NULL DEFAULT 'forever',
    deliver TEXT NOT NULL DEFAULT 'local',
    model TEXT NOT NULL DEFAULT 'auto',
    safety_mode TEXT NOT NULL DEFAULT 'sandboxed'
        CHECK (safety_mode IN ('sandboxed', 'unrestricted')),
    state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled', 'paused', 'completed', 'needs_review')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT CHECK (last_status IN ('ok', 'error')),
    last_error TEXT,
    last_delivery_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    tool_catalog_version INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_routines_due
    ON routines(state, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_routines_claim
    ON routines(claim_token);

CREATE TABLE IF NOT EXISTS routine_runs (
    id TEXT PRIMARY KEY NOT NULL,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    agent_session_id TEXT UNIQUE REFERENCES agent_sessions(id) ON DELETE SET NULL,
    agent_run_id TEXT UNIQUE REFERENCES agent_runs(id) ON DELETE SET NULL,
    claim_token TEXT NOT NULL UNIQUE,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'waiting_for_user', 'completed', 'cancelled', 'interrupted', 'failed'
    )),
    scheduled_for TEXT,
    started_at TEXT,
    completed_at TEXT,
    model TEXT NOT NULL,
    safety_mode TEXT NOT NULL CHECK (safety_mode IN ('sandboxed', 'unrestricted')),
    error_code TEXT,
    error_message TEXT,
    notification_delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_routine_started
    ON routine_runs(routine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routine_runs_active
    ON routine_runs(routine_id, status);

CREATE TABLE IF NOT EXISTS browser_action_outcomes (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    transport_kind TEXT NOT NULL CHECK (transport_kind IN ('attended', 'managed')),
    session_id TEXT NOT NULL,
    approval_id TEXT,
    outcome_class TEXT CHECK (
        outcome_class IS NULL OR outcome_class IN ('target_state', 'artifact', 'action_receipt')
    ),
    result_kind TEXT NOT NULL DEFAULT 'pending' CHECK (
        result_kind IN ('pending', 'executed', 'refused', 'transport_error')
    ),
    result_code_class TEXT,
    outcome_verified INTEGER NOT NULL DEFAULT 0 CHECK (outcome_verified IN (0, 1)),
    declared_at TEXT NOT NULL,
    evaluated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_action_outcomes_session
    ON browser_action_outcomes(session_id, declared_at);

CREATE TABLE IF NOT EXISTS browser_approval_events (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL,
    action_id TEXT NOT NULL REFERENCES browser_action_outcomes(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('parked', 'approved', 'declined', 'expired', 'cancelled_by_task_end')
    ),
    recorded_at TEXT NOT NULL,
    UNIQUE(approval_id, event_kind)
);

CREATE INDEX IF NOT EXISTS idx_browser_approval_events_session
    ON browser_approval_events(session_id, recorded_at);

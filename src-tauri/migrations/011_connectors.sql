CREATE TABLE IF NOT EXISTS connector_accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_trust (
  job_id TEXT PRIMARY KEY,
  trust_mode TEXT NOT NULL DEFAULT 'approval' CHECK (trust_mode IN ('read_only', 'approval', 'autonomous')),
  approval_run_count INTEGER NOT NULL DEFAULT 0,
  autonomous_tools TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_triggers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email_received', 'event_upcoming')),
  account_id TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_triggers_job_id ON connector_triggers (job_id);

CREATE TABLE IF NOT EXISTS trigger_cursors (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind)
);

-- Agent sessions live in Hermes, not this database. June records completion
-- locally, keyed by the stored Hermes session id (no local sessions table to
-- reference). This is June-owned state, distinct from Hermes' own archive.
CREATE TABLE IF NOT EXISTS completed_sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  completed_at TEXT NOT NULL
);

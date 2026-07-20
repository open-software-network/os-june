-- Agent sessions live in Hermes, not this database, so the map keys on the
-- Hermes stored session id directly (no local sessions table to reference).
CREATE TABLE IF NOT EXISTS session_profiles (
  session_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

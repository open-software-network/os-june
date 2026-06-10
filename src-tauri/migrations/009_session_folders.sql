-- Agent sessions live in Hermes, not this database, so the join table keys
-- on the Hermes session id directly (no local sessions table to reference).
CREATE TABLE IF NOT EXISTS session_folders (
  session_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (session_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_session_folders_folder ON session_folders(folder_id);

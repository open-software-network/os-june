-- Notes the user explicitly published as read-only web pages. The only user
-- content this service persists; rows are soft-revoked so a revoked link can
-- answer "gone" rather than recycling the id.
CREATE TABLE IF NOT EXISTS shared_notes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shared_notes_user ON shared_notes (user_id);

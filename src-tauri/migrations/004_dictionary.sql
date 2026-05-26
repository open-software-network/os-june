CREATE TABLE IF NOT EXISTS dictionary_entries (
  id TEXT PRIMARY KEY NOT NULL,
  phrase TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dictionary_entries_active_phrase
  ON dictionary_entries (lower(phrase))
  WHERE deleted_at IS NULL;

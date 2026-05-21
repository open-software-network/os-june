CREATE TABLE IF NOT EXISTS note_generation_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  recording_session_id TEXT,
  generation_result_id TEXT REFERENCES generation_results(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  title_suggestion TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_generation_blocks_session
ON note_generation_blocks (note_id, recording_session_id)
WHERE recording_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_note_generation_blocks_note_order
ON note_generation_blocks (note_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS note_processing_failures (
  note_id TEXT NOT NULL,
  recording_session_id TEXT NOT NULL,
  processing_stage TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (note_id, recording_session_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_processing_failures_note_updated
  ON note_processing_failures(note_id, updated_at DESC);

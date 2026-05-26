PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  generated_content TEXT,
  edited_content TEXT,
  active_tab TEXT DEFAULT 'notes',
  processing_status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes (created_at DESC);

CREATE TABLE IF NOT EXISTS note_folders (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (note_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_note_folders_folder ON note_folders (folder_id);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  expected_elapsed_ms INTEGER NOT NULL DEFAULT 0,
  device_label TEXT,
  permission_state TEXT NOT NULL DEFAULT 'unknown',
  partial_path TEXT,
  final_path TEXT,
  file_size_bytes INTEGER,
  duration_ms INTEGER,
  checksum TEXT,
  peak_amplitude REAL,
  rms_amplitude REAL,
  silent_window_ms INTEGER,
  validation_summary TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_recording_sessions_note ON recording_sessions (note_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions (status);

CREATE TABLE IF NOT EXISTS recording_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  recording_session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS audio_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  recording_session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  format TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  audio_artifact_id TEXT NOT NULL REFERENCES audio_artifacts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  language TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_results (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  content TEXT,
  title_suggestion TEXT,
  provider TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

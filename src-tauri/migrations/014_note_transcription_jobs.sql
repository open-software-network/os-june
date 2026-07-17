CREATE TABLE IF NOT EXISTS note_transcription_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  recording_session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  audio_artifact_id TEXT NOT NULL REFERENCES audio_artifacts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('microphone', 'system')),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('microphone_only', 'microphone_plus_system')),
  job_kind TEXT NOT NULL CHECK (job_kind IN ('turn', 'source_fallback')),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  input_fingerprint TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  max_chunk_ms INTEGER CHECK (max_chunk_ms IS NULL OR max_chunk_ms > 0),
  pipeline_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_transcription_jobs_operation
ON note_transcription_jobs (operation_id);

CREATE INDEX IF NOT EXISTS idx_note_transcription_jobs_session_status
ON note_transcription_jobs (recording_session_id, status, source, turn_index);

CREATE INDEX IF NOT EXISTS idx_note_transcription_jobs_pending
ON note_transcription_jobs (status, updated_at)
WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_span_id
ON transcripts (span_id)
WHERE span_id IS NOT NULL;

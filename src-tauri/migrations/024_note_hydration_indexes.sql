CREATE INDEX IF NOT EXISTS idx_audio_artifacts_note_status_created_at
ON audio_artifacts (note_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transcripts_note_created_at
ON transcripts (note_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recording_checkpoints_session_kind_created_at
ON recording_checkpoints (recording_session_id, kind, created_at DESC);

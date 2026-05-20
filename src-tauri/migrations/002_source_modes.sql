CREATE INDEX IF NOT EXISTS idx_audio_artifacts_session_source
ON audio_artifacts (recording_session_id, source);

CREATE INDEX IF NOT EXISTS idx_transcripts_session_source
ON transcripts (recording_session_id, source);

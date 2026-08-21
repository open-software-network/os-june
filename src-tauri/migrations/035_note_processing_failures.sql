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

WITH ranked_sessions AS (
  SELECT
    audio_artifacts.note_id,
    audio_artifacts.recording_session_id,
    ROW_NUMBER() OVER (
      PARTITION BY audio_artifacts.note_id
      ORDER BY
        CASE WHEN MAX(note_generation_blocks.id) IS NULL THEN 0 ELSE 1 END,
        CASE WHEN MAX(
          CASE WHEN note_transcription_jobs.status IN ('pending', 'running', 'failed')
            THEN 1 ELSE 0 END
        ) = 1 THEN 0 ELSE 1 END,
        CASE WHEN MAX(note_transcription_jobs.id) IS NULL THEN 1 ELSE 0 END,
        MAX(note_transcription_jobs.updated_at) DESC,
        MAX(audio_artifacts.duration_ms) DESC,
        MAX(audio_artifacts.created_at) DESC,
        MAX(audio_artifacts.rowid) DESC
    ) AS retry_rank
  FROM audio_artifacts
  LEFT JOIN note_generation_blocks
    ON note_generation_blocks.note_id = audio_artifacts.note_id
   AND note_generation_blocks.recording_session_id = audio_artifacts.recording_session_id
  LEFT JOIN note_transcription_jobs
    ON note_transcription_jobs.note_id = audio_artifacts.note_id
   AND note_transcription_jobs.recording_session_id = audio_artifacts.recording_session_id
  WHERE audio_artifacts.status = 'valid'
  GROUP BY audio_artifacts.note_id, audio_artifacts.recording_session_id
)
INSERT OR IGNORE INTO note_processing_failures (
  note_id,
  recording_session_id,
  processing_stage,
  message,
  created_at,
  updated_at
)
SELECT
  notes.id,
  ranked_sessions.recording_session_id,
  COALESCE(
    NULLIF(TRIM(notes.retry_processing_stage), ''),
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM note_transcription_jobs
        WHERE note_transcription_jobs.recording_session_id = ranked_sessions.recording_session_id
          AND note_transcription_jobs.status IN ('pending', 'running', 'failed')
      ) THEN 'transcribing'
      WHEN EXISTS (
        SELECT 1
        FROM note_transcription_jobs
        WHERE note_transcription_jobs.recording_session_id = ranked_sessions.recording_session_id
          AND note_transcription_jobs.status = 'succeeded'
      ) THEN 'generating'
      ELSE 'transcribing'
    END
  ),
  COALESCE(
    NULLIF(TRIM(notes.last_error), ''),
    'Clovy could not finish processing this recording.'
  ),
  notes.updated_at,
  notes.updated_at
FROM notes
INNER JOIN ranked_sessions
  ON ranked_sessions.note_id = notes.id
 AND ranked_sessions.retry_rank = 1
WHERE notes.processing_status = 'failed';

UPDATE notes
SET retry_recording_session_id = (
      SELECT note_processing_failures.recording_session_id
      FROM note_processing_failures
      WHERE note_processing_failures.note_id = notes.id
      ORDER BY note_processing_failures.updated_at DESC, note_processing_failures.rowid DESC
      LIMIT 1
    ),
    retry_processing_stage = (
      SELECT note_processing_failures.processing_stage
      FROM note_processing_failures
      WHERE note_processing_failures.note_id = notes.id
      ORDER BY note_processing_failures.updated_at DESC, note_processing_failures.rowid DESC
      LIMIT 1
    )
WHERE notes.processing_status = 'failed'
  AND EXISTS (
    SELECT 1 FROM note_processing_failures
    WHERE note_processing_failures.note_id = notes.id
  );

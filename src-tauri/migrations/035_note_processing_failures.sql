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

UPDATE notes
SET retry_recording_session_id = (
      SELECT recording_sessions.id
      FROM recording_sessions
      WHERE recording_sessions.note_id = notes.id
      ORDER BY recording_sessions.started_at DESC, recording_sessions.rowid DESC
      LIMIT 1
    ),
    retry_processing_stage = 'validation'
WHERE notes.processing_status = 'failed'
  AND notes.retry_recording_session_id IS NULL
  AND (
    SELECT CASE
      WHEN recording_sessions.status IN ('invalid', 'failed', 'discarded') THEN 1
      WHEN NOT EXISTS (
        SELECT 1 FROM audio_artifacts
        WHERE audio_artifacts.note_id = notes.id
          AND audio_artifacts.recording_session_id = recording_sessions.id
          AND audio_artifacts.status = 'valid'
      ) THEN 1
      ELSE 0
    END
    FROM recording_sessions
    WHERE recording_sessions.note_id = notes.id
    ORDER BY recording_sessions.started_at DESC, recording_sessions.rowid DESC
    LIMIT 1
  ) = 1;

WITH session_evidence AS (
  SELECT
    audio_artifacts.note_id,
    audio_artifacts.recording_session_id,
    MAX(notes.retry_recording_session_id) AS exact_session_id,
    MAX(notes.retry_processing_stage) AS exact_processing_stage,
    MAX(note_generation_blocks.id) AS generation_block_id,
    MAX(CASE
      WHEN note_transcription_jobs.status IN ('pending', 'running', 'failed') THEN 1
      ELSE 0
    END) AS has_unfinished_job,
    MAX(CASE
      WHEN note_transcription_jobs.status = 'succeeded' THEN 1
      ELSE 0
    END) AS has_succeeded_job,
    MAX(note_transcription_jobs.updated_at) AS job_updated_at,
    MAX(audio_artifacts.duration_ms) AS duration_ms,
    MAX(audio_artifacts.created_at) AS audio_created_at,
    MAX(audio_artifacts.rowid) AS audio_rowid
  FROM audio_artifacts
  INNER JOIN notes
    ON notes.id = audio_artifacts.note_id
  LEFT JOIN note_generation_blocks
    ON note_generation_blocks.note_id = audio_artifacts.note_id
   AND note_generation_blocks.recording_session_id = audio_artifacts.recording_session_id
  LEFT JOIN note_transcription_jobs
    ON note_transcription_jobs.note_id = audio_artifacts.note_id
   AND note_transcription_jobs.recording_session_id = audio_artifacts.recording_session_id
  WHERE audio_artifacts.status = 'valid'
    AND notes.processing_status = 'failed'
  GROUP BY audio_artifacts.note_id, audio_artifacts.recording_session_id
),
ranked_sessions AS (
  SELECT
    session_evidence.*,
    ROW_NUMBER() OVER (
      PARTITION BY session_evidence.note_id
      ORDER BY
        CASE
          WHEN session_evidence.exact_session_id = session_evidence.recording_session_id THEN 0
          ELSE 1
        END,
        CASE WHEN session_evidence.has_unfinished_job = 1 THEN 0 ELSE 1 END,
        session_evidence.job_updated_at DESC,
        session_evidence.duration_ms DESC,
        session_evidence.audio_created_at DESC,
        session_evidence.audio_rowid DESC
    ) AS retry_rank
  FROM session_evidence
  WHERE session_evidence.exact_session_id = session_evidence.recording_session_id
     OR (
       session_evidence.generation_block_id IS NULL
       AND session_evidence.has_unfinished_job = 1
     )
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
    CASE
      WHEN ranked_sessions.exact_session_id = ranked_sessions.recording_session_id
      THEN NULLIF(TRIM(ranked_sessions.exact_processing_stage), '')
    END,
    CASE
      WHEN ranked_sessions.has_unfinished_job = 1 THEN 'transcribing'
      WHEN ranked_sessions.has_succeeded_job = 1 THEN 'generating'
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
SET retry_recording_session_id = CASE
      WHEN notes.retry_recording_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audio_artifacts
         WHERE audio_artifacts.note_id = notes.id
           AND audio_artifacts.recording_session_id = notes.retry_recording_session_id
           AND audio_artifacts.status = 'valid'
       )
      THEN notes.retry_recording_session_id
      ELSE (
        SELECT note_processing_failures.recording_session_id
        FROM note_processing_failures
        WHERE note_processing_failures.note_id = notes.id
        ORDER BY note_processing_failures.updated_at DESC, note_processing_failures.rowid DESC
        LIMIT 1
      )
    END,
    retry_processing_stage = CASE
      WHEN notes.retry_recording_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audio_artifacts
         WHERE audio_artifacts.note_id = notes.id
           AND audio_artifacts.recording_session_id = notes.retry_recording_session_id
           AND audio_artifacts.status = 'valid'
       )
      THEN notes.retry_processing_stage
      ELSE (
        SELECT note_processing_failures.processing_stage
        FROM note_processing_failures
        WHERE note_processing_failures.note_id = notes.id
        ORDER BY note_processing_failures.updated_at DESC, note_processing_failures.rowid DESC
        LIMIT 1
      )
    END
WHERE notes.processing_status = 'failed'
  AND EXISTS (
    SELECT 1 FROM note_processing_failures
    WHERE note_processing_failures.note_id = notes.id
  );

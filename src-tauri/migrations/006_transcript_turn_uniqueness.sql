DELETE FROM transcripts
WHERE recording_session_id IS NOT NULL
  AND source IS NOT NULL
  AND turn_index IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM transcripts
    WHERE recording_session_id IS NOT NULL
      AND source IS NOT NULL
      AND turn_index IS NOT NULL
    GROUP BY recording_session_id, source, turn_index
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_session_source_turn
ON transcripts (recording_session_id, source, turn_index)
WHERE recording_session_id IS NOT NULL
  AND source IS NOT NULL
  AND turn_index IS NOT NULL;

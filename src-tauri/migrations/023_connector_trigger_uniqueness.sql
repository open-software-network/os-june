-- A routine owns one connector trigger. Legacy delete-then-insert writes could
-- leave duplicates after a concurrent replacement, so preserve the newest
-- configured row before enforcing that invariant in SQLite.
DELETE FROM connector_triggers AS stale
WHERE EXISTS (
  SELECT 1
  FROM connector_triggers AS newer
  WHERE newer.job_id = stale.job_id
    AND (
      newer.created_at > stale.created_at
      OR (newer.created_at = stale.created_at AND newer.rowid > stale.rowid)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_triggers_job_id_unique
ON connector_triggers (job_id);

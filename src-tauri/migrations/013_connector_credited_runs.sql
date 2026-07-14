-- Runs already counted toward a routine's earned-autonomy threshold. The
-- (job_id, run_id) primary key makes crediting idempotent across app restarts
-- and repeated run-history polls, so the counter can be advanced from whenever
-- the run is next observed without a fragile client-side baseline.
CREATE TABLE IF NOT EXISTS connector_credited_runs (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, run_id)
);

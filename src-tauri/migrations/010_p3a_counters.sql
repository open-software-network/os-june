CREATE TABLE IF NOT EXISTS p3a_counters (
  question_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  raw_value INTEGER NOT NULL DEFAULT 0 CHECK (raw_value >= 0),
  reported_value INTEGER NOT NULL DEFAULT 0 CHECK (reported_value >= 0),
  reported_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (question_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_p3a_counters_epoch ON p3a_counters(epoch);

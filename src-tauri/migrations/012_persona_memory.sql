CREATE TABLE IF NOT EXISTS persona_feature_state (
  feature TEXT PRIMARY KEY NOT NULL,
  enabled_at TEXT NOT NULL
);

INSERT OR IGNORE INTO persona_feature_state (feature, enabled_at)
VALUES ('persona_memory', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS persona_dossier_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  generation_result_id TEXT NOT NULL REFERENCES generation_results(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(generation_result_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_dossier_jobs_status
  ON persona_dossier_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_persona_dossier_jobs_persona
  ON persona_dossier_jobs(persona_id, created_at DESC);

CREATE TABLE IF NOT EXISTS persona_commitments (
  id TEXT PRIMARY KEY NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('owed_to_user', 'owed_by_user')),
  text TEXT NOT NULL,
  due_value TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'done', 'dropped')),
  source_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  source_job_id TEXT REFERENCES persona_dossier_jobs(id) ON DELETE SET NULL,
  source_item_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_persona_commitments_persona
  ON persona_commitments(persona_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_commitments_source_item
  ON persona_commitments(source_job_id, source_item_key)
  WHERE source_job_id IS NOT NULL AND source_item_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS persona_historical_attributions (
  transcript_id TEXT PRIMARY KEY NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  deletion_batch_id TEXT,
  original_cluster_id TEXT NOT NULL,
  anonymous_label TEXT NOT NULL,
  frozen_name TEXT,
  state TEXT NOT NULL CHECK(state IN ('frozen', 'anonymous')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_persona_historical_attributions_batch
  ON persona_historical_attributions(deletion_batch_id)
  WHERE deletion_batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_single_self
  ON personas(is_self)
  WHERE is_self = 1;

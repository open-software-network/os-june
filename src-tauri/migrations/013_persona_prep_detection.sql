CREATE TABLE IF NOT EXISTS persona_prep_offers (
  detection_episode_id TEXT PRIMARY KEY NOT NULL,
  bundle_key TEXT NOT NULL,
  expected_persona_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('offered', 'running', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_persona_prep_offers_bundle
  ON persona_prep_offers(bundle_key, created_at DESC);

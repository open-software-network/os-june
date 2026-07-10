DROP INDEX IF EXISTS idx_persona_prep_offers_bundle;

ALTER TABLE persona_prep_offers RENAME TO persona_prep_offers_legacy;

CREATE TABLE persona_prep_offers (
  detection_episode_id TEXT PRIMARY KEY NOT NULL,
  bundle_key TEXT NOT NULL,
  expected_persona_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('offered', 'running', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL
);

INSERT INTO persona_prep_offers
  (detection_episode_id, bundle_key, expected_persona_ids_json, status,
   created_at, updated_at, accepted_note_id)
SELECT detection_episode_id, bundle_key, expected_persona_ids_json, status,
       created_at, updated_at, accepted_note_id
FROM persona_prep_offers_legacy;

DROP TABLE persona_prep_offers_legacy;

CREATE INDEX idx_persona_prep_offers_bundle
  ON persona_prep_offers(bundle_key, created_at DESC);

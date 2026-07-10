CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  relationship TEXT,
  recognition_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS transcript_persona_assignments (
  transcript_id TEXT PRIMARY KEY NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcript_persona_assignments_persona
  ON transcript_persona_assignments(persona_id);

CREATE TABLE IF NOT EXISTS persona_clusters (
  id TEXT PRIMARY KEY NOT NULL,
  recording_session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  speaker_index INTEGER NOT NULL,
  anonymous_label TEXT NOT NULL,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  spans_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(recording_session_id, source, speaker_index)
);

CREATE INDEX IF NOT EXISTS idx_persona_clusters_note
  ON persona_clusters(note_id, recording_session_id);

CREATE TABLE IF NOT EXISTS persona_voiceprints (
  id TEXT PRIMARY KEY NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('positive', 'negative')),
  recording_session_id TEXT NOT NULL,
  persona_cluster_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(persona_id, persona_cluster_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_persona_voiceprints_lookup
  ON persona_voiceprints(source, model_id, kind, persona_id);

CREATE TABLE IF NOT EXISTS transcript_persona_attributions (
  transcript_id TEXT PRIMARY KEY NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  persona_cluster_id TEXT NOT NULL REFERENCES persona_clusters(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('anonymous', 'suggested', 'tagged', 'confirmed', 'automatic', 'frozen')),
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  candidate_persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  frozen_name TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcript_persona_attributions_cluster
  ON transcript_persona_attributions(persona_cluster_id);

CREATE TABLE IF NOT EXISTS note_participants (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  provenance TEXT NOT NULL CHECK(provenance IN ('tagged', 'confirmed', 'automatic')),
  first_confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(note_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_note_participants_persona
  ON note_participants(persona_id, first_confirmed_at);

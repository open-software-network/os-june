-- Non-secret linked-device metadata and replay/idempotency state. Identity
-- private keys and pairing secrets never enter SQLite, because they live in Keychain.
CREATE TABLE IF NOT EXISTS companion_devices (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  linked_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS companion_operations (
  device_id TEXT NOT NULL REFERENCES companion_devices(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  response BLOB NOT NULL,
  operation_state TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_companion_operations_created
  ON companion_operations (created_at);

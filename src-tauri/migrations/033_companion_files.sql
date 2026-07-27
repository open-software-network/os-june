CREATE TABLE IF NOT EXISTS companion_browse_roots (
  account_user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_user_id, id),
  UNIQUE (account_user_id, canonical_path)
);

CREATE TABLE IF NOT EXISTS companion_uploads (
  account_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES companion_devices(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  accepted_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  attachment_reference_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, reservation_id),
  UNIQUE (attachment_reference_id),
  CHECK (state IN ('pending', 'committed')),
  CHECK (size_bytes > 0),
  CHECK (accepted_bytes >= 0 AND accepted_bytes <= size_bytes)
);

CREATE INDEX IF NOT EXISTS idx_companion_browse_roots_account
  ON companion_browse_roots (account_user_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_companion_uploads_account_device
  ON companion_uploads (account_user_id, device_id, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_companion_uploads_expiry
  ON companion_uploads (expires_at_ms);

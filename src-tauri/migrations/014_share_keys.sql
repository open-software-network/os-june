-- Local-only key store for private shares (JUN-308). Content keys must be
-- retained on the owner's device so later invites can wrap the same key
-- without re-encrypting, and invite keys must be retained so "copy link"
-- works across app restarts (they are not re-derivable). Keys never leave
-- the device except wrapped inside per-recipient envelopes.
CREATE TABLE IF NOT EXISTS share_keys (
  share_id TEXT PRIMARY KEY,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  content_key BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_share_keys_item
  ON share_keys (item_kind, item_id);

CREATE TABLE IF NOT EXISTS share_invite_keys (
  invite_id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  invite_key BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_invite_keys_share
  ON share_invite_keys (share_id);

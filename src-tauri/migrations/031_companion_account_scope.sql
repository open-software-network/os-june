CREATE INDEX IF NOT EXISTS idx_companion_devices_account_user
  ON companion_devices (account_user_id, linked_at DESC);

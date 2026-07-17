-- Preserve the current non-secret account subject outside OS Accounts
-- credentials so local companion authorization can be revoked even when
-- Keychain is temporarily unreadable during sign-out.
CREATE TABLE IF NOT EXISTS companion_account_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  account_user_id TEXT NOT NULL
);

INSERT OR IGNORE INTO companion_account_state (singleton, account_user_id)
SELECT 1, account_user_id
FROM companion_devices
WHERE account_user_id <> '' AND revoked_at IS NULL
ORDER BY linked_at DESC
LIMIT 1;

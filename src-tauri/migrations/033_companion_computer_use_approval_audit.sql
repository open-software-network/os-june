-- Durable, content-free attribution for linked-device Computer use decisions.
-- Device rows may later be deleted, so this receipt deliberately stores the
-- authenticated device id without a cascading foreign key.
CREATE TABLE IF NOT EXISTS companion_computer_use_approval_audit (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  stored_session_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
  recorded_at TEXT NOT NULL,
  UNIQUE (device_id, request_id, stored_session_id)
);

CREATE INDEX IF NOT EXISTS idx_companion_computer_use_approval_audit_request
  ON companion_computer_use_approval_audit (request_id, stored_session_id);

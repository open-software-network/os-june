CREATE TABLE IF NOT EXISTS connector_grants (
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','gcal')),
  server_name TEXT NOT NULL,
  token TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connector_grants_token ON connector_grants(token);

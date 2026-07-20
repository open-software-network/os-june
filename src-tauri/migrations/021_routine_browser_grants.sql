CREATE TABLE IF NOT EXISTS routine_browser_grants (
    job_id TEXT PRIMARY KEY NOT NULL,
    server_name TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

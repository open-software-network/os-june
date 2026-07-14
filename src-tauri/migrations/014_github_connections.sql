CREATE TABLE IF NOT EXISTS github_connections (
  github_user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'setup_incomplete', 'reconnect_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  management_url TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  suspended_at TEXT,
  last_refreshed_at TEXT NOT NULL,
  FOREIGN KEY (github_user_id) REFERENCES github_connections(github_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_repositories (
  repository_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES github_installations(installation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_github_installations_user
  ON github_installations(github_user_id);

CREATE INDEX IF NOT EXISTS idx_github_repositories_installation
  ON github_repositories(installation_id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT 'New session',
  status TEXT NOT NULL DEFAULT 'idle',
  model TEXT NOT NULL DEFAULT 'auto',
  safety_mode TEXT NOT NULL DEFAULT 'sandboxed',
  workspace_path TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at
  ON agent_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions(status);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  usage_json TEXT,
  interrupted_state_json TEXT,
  last_sequence INTEGER NOT NULL DEFAULT -1,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_started
  ON agent_runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_items (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_items_session_sequence
  ON agent_items(session_id, sequence ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_items_external_id
  ON agent_items(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES agent_items(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  original_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_session_created
  ON agent_artifacts(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_skill_settings (
  skill_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_migration_manifests (
  migration_key TEXT PRIMARY KEY NOT NULL,
  source_path TEXT NOT NULL,
  source_fingerprint TEXT,
  status TEXT NOT NULL,
  source_counts_json TEXT NOT NULL DEFAULT '{}',
  imported_counts_json TEXT NOT NULL DEFAULT '{}',
  skipped_count INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Preserve every existing folder assignment, even if its Hermes session is
-- not present when June's own database migration runs. The read-only Hermes
-- importer fills these placeholder rows with the original metadata later.
INSERT OR IGNORE INTO agent_sessions (
  id, title, status, model, safety_mode, source, created_at, updated_at
)
SELECT session_id, 'Imported session', 'idle', 'auto', 'sandboxed',
       'legacy_placeholder', assigned_at, assigned_at
FROM session_folders;

-- Import the old June-owned task projection before retiring its three tables.
-- A task already bound to Hermes keeps that Hermes session id so folder links
-- and conversation history converge on one stable session row.
INSERT INTO agent_sessions (
  id, title, status, model, safety_mode, source, created_at, updated_at,
  completed_at, last_error
)
SELECT COALESCE(NULLIF(hermes_session_id, ''), id), title, status, 'auto',
       CASE WHEN safety_profile = 'unrestricted' THEN 'unrestricted' ELSE 'sandboxed' END,
       'legacy_agent_task', created_at, updated_at, completed_at, last_error
FROM agent_tasks
WHERE true
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  status = excluded.status,
  safety_mode = excluded.safety_mode,
  source = excluded.source,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  completed_at = excluded.completed_at,
  last_error = excluded.last_error;

INSERT OR IGNORE INTO agent_items (
  id, session_id, sequence, kind, payload_json, external_id, created_at
)
SELECT 'legacy:' || combined.item_type || ':' || combined.item_id,
       combined.session_id,
       ROW_NUMBER() OVER (
         PARTITION BY combined.session_id
         ORDER BY combined.created_at, combined.type_order, combined.item_id
       ) - 1,
       combined.kind,
       combined.payload_json,
       combined.external_id,
       combined.created_at
FROM (
  SELECT 'message' AS item_type,
         m.id AS item_id,
         COALESCE(NULLIF(t.hermes_session_id, ''), t.id) AS session_id,
         CASE m.role
           WHEN 'assistant' THEN 'assistant_message'
           WHEN 'system' THEN 'system_message'
           ELSE 'user_message'
         END AS kind,
         json_object('role', m.role, 'content', m.content) AS payload_json,
         m.external_id AS external_id,
         m.created_at AS created_at,
         0 AS type_order
  FROM agent_messages m
  JOIN agent_tasks t ON t.id = m.task_id
  UNION ALL
  SELECT 'tool' AS item_type,
         e.id AS item_id,
         COALESCE(NULLIF(t.hermes_session_id, ''), t.id) AS session_id,
         'tool_result' AS kind,
         json_object(
           'toolName', e.tool_name,
           'status', e.status,
           'summary', e.summary,
           'arguments', CASE WHEN json_valid(e.arguments_json) THEN json(e.arguments_json) ELSE e.arguments_json END,
           'result', CASE WHEN json_valid(e.result_json) THEN json(e.result_json) ELSE e.result_json END,
           'redacted', CASE WHEN e.redacted = 1 THEN json('true') ELSE json('false') END,
           'completedAt', e.completed_at
         ) AS payload_json,
         NULL AS external_id,
         e.created_at AS created_at,
         1 AS type_order
  FROM agent_tool_events e
  JOIN agent_tasks t ON t.id = e.task_id
) combined;

ALTER TABLE session_folders RENAME TO legacy_session_folders;

CREATE TABLE session_folders (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (session_id, folder_id)
);

INSERT OR IGNORE INTO session_folders(session_id, folder_id, assigned_at)
SELECT session_id, folder_id, assigned_at FROM legacy_session_folders;

DROP TABLE legacy_session_folders;
CREATE INDEX IF NOT EXISTS idx_session_folders_folder ON session_folders(folder_id);

DROP TABLE agent_tool_events;
DROP TABLE agent_messages;
DROP TABLE agent_tasks;

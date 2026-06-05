CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  safety_profile TEXT NOT NULL,
  progress_summary TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_at ON agent_tasks (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks (status);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_task_created ON agent_messages (task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_tool_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  arguments_json TEXT,
  result_json TEXT,
  redacted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_events_task_created ON agent_tool_events (task_id, created_at ASC);

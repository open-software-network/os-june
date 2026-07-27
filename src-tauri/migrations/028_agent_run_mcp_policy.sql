CREATE TABLE IF NOT EXISTS agent_run_mcp_policies (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_updated_at TEXT NOT NULL,
  requires_approval INTEGER NOT NULL,
  PRIMARY KEY (run_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_mcp_policies_run
  ON agent_run_mcp_policies(run_id);

DELETE FROM agent_messages
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM agent_messages
  GROUP BY task_id, role, content, created_at
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_task_external_id
ON agent_messages (task_id, external_id)
WHERE external_id IS NOT NULL;

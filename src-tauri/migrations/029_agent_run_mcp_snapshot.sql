-- Runs created before the explicit snapshot marker shipped must remain pinned
-- to the tool catalog they already had, including an empty catalog.
UPDATE agent_runs
SET mcp_policy_snapshotted = 1;

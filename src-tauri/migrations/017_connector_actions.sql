-- Action journal for connector mutations (Linear writes, slice 3). One row
-- per ATTEMPTED mutation, written 'pending' before the provider call. The
-- action_id is the client-minted v4 UUID that is ALSO the created object's
-- id at the provider, so an ambiguous outcome (timeout, transport loss) can
-- be reconciled by querying that id: found means committed, not found stays
-- ambiguous and the tool tells the agent not to retry. Statuses:
--   pending   - mutation dispatched, outcome not yet recorded
--   committed - provider confirmed the change applied
--   ambiguous - outcome unknown after one reconciliation attempt
--   failed    - provider definitively rejected the change
CREATE TABLE IF NOT EXISTS connector_actions (
  action_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','ambiguous','failed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

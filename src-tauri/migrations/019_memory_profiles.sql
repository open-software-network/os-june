CREATE INDEX IF NOT EXISTS idx_memories_profile_created_at
  ON memories (profile, created_at DESC);

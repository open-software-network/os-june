CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY NOT NULL,
  folder_id TEXT REFERENCES folders(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_folder_id ON memories (folder_id);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  id TEXT PRIMARY KEY NOT NULL,
  deleted_at TEXT NOT NULL
);

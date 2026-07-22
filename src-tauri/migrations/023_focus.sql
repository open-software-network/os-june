CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY,
  intention TEXT NOT NULL DEFAULT '',
  start_shortcut_name TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'focusing', 'paused', 'overtime', 'on_break', 'completed', 'abandoned')
  ),
  paused_from TEXT CHECK (paused_from IS NULL OR paused_from IN ('focusing', 'overtime')),
  current_interval_position INTEGER NOT NULL DEFAULT 0 CHECK (current_interval_position >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  abandoned_at TEXT,
  reflection TEXT,
  quality INTEGER CHECK (quality IS NULL OR quality BETWEEN 1 AND 5)
);

-- A constant expression plus a partial predicate makes the invariant global,
-- not merely one row per active status.
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_one_active_session
  ON focus_sessions ((1))
  WHERE status IN ('planned', 'focusing', 'paused', 'overtime', 'on_break');

CREATE TABLE IF NOT EXISTS focus_intervals (
  session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('focus', 'break')),
  planned_duration_ms INTEGER NOT NULL CHECK (planned_duration_ms > 0),
  project_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  project_name TEXT,
  PRIMARY KEY (session_id, position),
  CHECK (kind = 'focus' OR (project_id IS NULL AND project_name IS NULL))
);

CREATE TABLE IF NOT EXISTS focus_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  interval_position INTEGER NOT NULL CHECK (interval_position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('focus', 'pause', 'break', 'overtime')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  project_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  project_name TEXT,
  created_at TEXT NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (kind IN ('focus', 'overtime') OR (project_id IS NULL AND project_name IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_focus_intervals_project
  ON focus_intervals (project_id);
CREATE INDEX IF NOT EXISTS idx_focus_segments_session_time
  ON focus_segments (session_id, started_at, created_at);
CREATE INDEX IF NOT EXISTS idx_focus_segments_project
  ON focus_segments (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_one_open_segment
  ON focus_segments ((1))
  WHERE ended_at IS NULL;

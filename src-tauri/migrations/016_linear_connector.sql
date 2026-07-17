-- The Linear teams a connected workspace account is scoped to. A routine's
-- Linear tools only ever see issues/projects within these teams, so a
-- multi-team workspace does not implicitly grant access to every team in it.
-- Replaced wholesale on every "manage teams" save (see
-- Repositories::set_selected_teams), never diffed row by row.
CREATE TABLE IF NOT EXISTS connector_selected_teams (
  account_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  team_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, team_id)
);

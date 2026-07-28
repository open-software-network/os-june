-- Compatibility marker for prerelease builds that persisted a managed Linear
-- MCP state. Connectivity is owned by connector_accounts and Keychain. Runtime
-- code must never consult this table as an authorization source.
CREATE TABLE IF NOT EXISTS linear_mcp_connection (
  preset_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL
);

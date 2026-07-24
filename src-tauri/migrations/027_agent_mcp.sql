-- June-owned MCP registry. Connection definitions and policy are durable, but
-- environment variables and HTTP header values remain in the OS keychain.
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable_http')),
    command TEXT,
    args_json TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    secret_ref TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    tool_visibility_json TEXT NOT NULL DEFAULT '{}',
    safety_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_enabled
    ON agent_mcp_servers(enabled, name);

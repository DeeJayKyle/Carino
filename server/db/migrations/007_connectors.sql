-- Connected apps: remote MCP servers whose tools Carino's agent can use.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,                          -- short id used in tool names (mcp_<slug>_<tool>)
  url TEXT NOT NULL,
  auth_secret TEXT,                            -- encrypted Authorization header value (services/secrets.ts)
  enabled INTEGER NOT NULL DEFAULT 1,
  tools TEXT NOT NULL DEFAULT '[]',            -- cached tools/list result, trimmed
  server_name TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, slug)
);
CREATE INDEX idx_connectors_user ON connectors(user_id);

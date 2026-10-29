-- In-progress "sign in with the app" flows for connected apps (MCP OAuth). Short-lived.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,                      -- random, sent through the browser and checked on return
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,                           -- the MCP server
  data TEXT NOT NULL,                          -- encrypted JSON: PKCE verifier, client and token endpoint
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- How a connector authenticates: token (pasted) or oauth (signed in with the app).
ALTER TABLE connectors ADD COLUMN auth_kind TEXT;
UPDATE connectors SET auth_kind = 'token' WHERE auth_secret IS NOT NULL;

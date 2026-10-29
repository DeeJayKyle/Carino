-- My apps: accounts signed in directly with Google, Microsoft, Meta, X, LinkedIn and TikTok.
-- Each user brings their own free developer app (client id + secret) per provider.
CREATE TABLE app_clients (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                      -- google | microsoft | meta | x | linkedin | tiktok
  client_id TEXT NOT NULL,
  client_secret TEXT,                          -- encrypted (services/secrets.ts)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE app_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                      -- google | microsoft | facebook | instagram | x | linkedin | tiktok
  external_id TEXT NOT NULL,                   -- the account's id at the provider
  label TEXT NOT NULL,                         -- email or handle shown to the user and the model
  secret TEXT NOT NULL,                        -- encrypted JSON tokens
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider, external_id)
);
CREATE INDEX idx_app_accounts_user ON app_accounts(user_id, provider);

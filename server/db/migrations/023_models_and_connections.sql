-- Model catalog, connection status, spending, and content that must stay on the user's devices.

-- Every model Carino knows about, per connection (an AI service with its key, or a local server).
CREATE TABLE ai_models (
  conn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  label TEXT,
  local INTEGER NOT NULL DEFAULT 0,          -- content stays on the user's own devices
  paid INTEGER,                              -- 1 costs money, 0 free, NULL not known (treated as paid)
  price_in REAL,                             -- USD per million tokens
  price_out REAL,
  price_source TEXT,                         -- list | provider | user
  caps TEXT NOT NULL DEFAULT '{}',           -- {chat, responses, streaming, tools, vision, json}
  scores TEXT NOT NULL DEFAULT '{}',         -- test results 0..1: {basic, tools, extract, reason, vision}
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'untested',   -- untested | ok | limited | unavailable
  last_error TEXT,
  tested_at TEXT,
  seen_at TEXT,
  PRIMARY KEY (conn_id, model)
);

-- Last check of each connection (AI services, signed-in accounts, connected tools).
CREATE TABLE connection_status (
  kind TEXT NOT NULL,                        -- ai | account | connector
  ref TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,                      -- ok | needs_sign_in | error | offline
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Which connection answered, for costs per service.
ALTER TABLE usage ADD COLUMN conn_id TEXT;

-- Content the user wants kept on their own devices: never sent to a cloud AI.
ALTER TABLE conversations ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folder_grants ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;

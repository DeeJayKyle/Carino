-- Messaging channels: talk to Carino from Telegram or WhatsApp.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- telegram | whatsapp
  enabled INTEGER NOT NULL DEFAULT 1,
  secret TEXT,                                 -- encrypted JSON: bot token, or WhatsApp access token + app secret
  config TEXT NOT NULL DEFAULT '{}',           -- non-secret settings (bot username, phone number id, options)
  state TEXT NOT NULL DEFAULT '{}',            -- e.g. Telegram update offset
  pairing_code TEXT,
  pairing_expires_at TEXT,
  last_error TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, kind)
);

-- Each linked chat (a private chat or a group) and its own Carino conversation.
CREATE TABLE channel_chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,                   -- Telegram chat id, or WhatsApp phone number
  owner_external_id TEXT,                      -- the account that linked it (the user's own Telegram id / number)
  title TEXT NOT NULL DEFAULT '',
  is_group INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,            -- set by /stop
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel_id, external_id)
);

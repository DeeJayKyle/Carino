-- Pages and small interactive apps Carino builds in chat, with their earlier versions.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page',          -- page | app
  html TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  history TEXT NOT NULL DEFAULT '[]',         -- JSON array of earlier { version, html, at } (last 10)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pages_user ON pages(user_id, updated_at);

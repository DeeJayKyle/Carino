-- Group catch-up (opt-in per linked group): recent messages kept for a summary, 7 days at most.
ALTER TABLE channel_chats ADD COLUMN catchup INTEGER NOT NULL DEFAULT 0;
CREATE TABLE group_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX group_log_chat ON group_log(chat_id, at);

-- Idempotency log for writes replayed from the offline queue (keyed by a client-generated op id).
CREATE TABLE client_ops (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,           -- 0 while running, then the HTTP status returned
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, op_id)
);

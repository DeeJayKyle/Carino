-- WhatsApp messages already answered, by WhatsApp's own message id, so a message delivered twice
-- (Meta retries, a lost acknowledgement, the app restarting mid-batch) is answered once.
-- Failures are counted: a message is retried a few times, then given up on and reported.
CREATE TABLE channel_inbound (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'failed',        -- done | failed | gave_up
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  reply TEXT,                                   -- JSON: an answer already written but not yet sent (a retry only re-sends it)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_id, message_id)
);

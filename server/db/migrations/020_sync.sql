-- Pairing and sync between the user's own devices (phone and PC). See server/services/sync.ts.

-- This device: its id and key pair (the private key is encrypted with the device's own key).
CREATE TABLE sync_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,                     -- JWK (P-256)
  private_key TEXT NOT NULL,                    -- encrypted JWK
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Paired devices. Nothing syncs until the user has compared the check number on both screens.
CREATE TABLE sync_peers (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  shared_key TEXT NOT NULL,                     -- encrypted; derived once at pairing
  address TEXT,                                 -- where to reach it on the local network (PCs only)
  role TEXT NOT NULL,                           -- 'listener' (a PC this device connects to) | 'caller' (a phone that connects here)
  confirmed INTEGER NOT NULL DEFAULT 0,
  sent_seq INTEGER NOT NULL DEFAULT 0,          -- our changes it has acknowledged
  recv_seq INTEGER NOT NULL DEFAULT 0,          -- its changes we have applied
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A pairing waiting for the other device (a PC showing its code), for 10 minutes.
CREATE TABLE sync_pairing (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                           -- encrypted; needed to derive the key when the phone answers
  attempts INTEGER NOT NULL DEFAULT 0,          -- wrong answers; the pairing is dropped after 10
  expires_at TEXT NOT NULL
);

-- Every change to a synced record, in order. Filled by triggers (not while applying a peer's changes).
CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL                              -- upsert | delete
);
CREATE INDEX idx_sync_log_row ON sync_log(tbl, row_id);
-- While a row exists here, the triggers stay quiet (changes coming from a peer aren't sent back).
CREATE TABLE sync_applying (x INTEGER);

-- The version of each record both devices last agreed on (a fingerprint), per peer.
CREATE TABLE sync_rows (
  peer TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hash TEXT NOT NULL,                           -- '' = agreed it's deleted
  PRIMARY KEY (peer, tbl, row_id)
);

-- Both devices changed the same record: kept here for the user to choose, never overwritten silently.
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  mine TEXT,                                    -- JSON, NULL = deleted here
  theirs TEXT,                                  -- JSON, NULL = deleted there
  their_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- "Continue on my other device": a chat, to-do or application with a note and chosen files.
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- chat | task | application
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',             -- document ids
  from_device TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',          -- open | done
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

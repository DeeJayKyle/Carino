-- Folders on this device the user chose to let Carino read (Windows: a folder; Android: a folder
-- picked in the system's file picker). Each is its own permission, revocable at any time.
CREATE TABLE folder_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root TEXT NOT NULL,                           -- Windows path, or the Android folder's content URI
  label TEXT NOT NULL,
  can_change INTEGER NOT NULL DEFAULT 0,        -- 0: read only. 1: may rename, move or delete (each one still approved)
  last_scan_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, root)
);

-- What's in those folders (names, sizes, fingerprints and the text Carino could read).
CREATE TABLE local_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES folder_grants(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,                       -- inside the folder, with / between parts
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  mtime TEXT,
  sha256 TEXT,                                  -- for finding duplicates
  kind TEXT NOT NULL DEFAULT 'other',           -- pdf | docx | xlsx | csv | text | markdown | image | other
  text_chars INTEGER NOT NULL DEFAULT 0,        -- 0 for a scan or photo: no text was found in it
  summary TEXT NOT NULL DEFAULT '',
  indexed_at TEXT NOT NULL,
  UNIQUE (grant_id, rel_path)
);
CREATE INDEX idx_local_files_hash ON local_files(user_id, sha256);

CREATE TABLE local_file_chunks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES local_files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);
CREATE INDEX idx_local_file_chunks ON local_file_chunks(file_id);

-- Every change Carino made to a file (only ever after the user approved it), and how to undo it.
CREATE TABLE file_ops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES folder_grants(id) ON DELETE CASCADE,
  action_id TEXT,                               -- the approval it came from
  op TEXT NOT NULL,                             -- rename | move | delete
  from_rel TEXT NOT NULL,
  to_rel TEXT,
  sha256 TEXT NOT NULL,                         -- the file's fingerprint before the change (checked when undoing)
  recovery TEXT,                                -- where a copy was kept before deleting
  status TEXT NOT NULL DEFAULT 'done',          -- done | undone | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  undone_at TEXT
);

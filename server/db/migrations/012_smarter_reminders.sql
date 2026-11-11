-- Smarter reminders: repeating reminders, and reminders that ring on arriving at a place.
ALTER TABLE reminders ADD COLUMN recurrence TEXT;       -- JSON {freq, interval, byweekday}; NULL = once

CREATE TABLE place_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  place_name TEXT NOT NULL,                     -- what the user called it, e.g. "the pharmacy in Ntinda"
  address TEXT NOT NULL DEFAULT '',             -- what OpenStreetMap found
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  status TEXT NOT NULL DEFAULT 'active',        -- active | fired | cancelled
  fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_place_reminders_user ON place_reminders(user_id, status);

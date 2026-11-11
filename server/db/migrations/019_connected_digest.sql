-- A short summary of the user's connected email and calendars (sender, subject, times) for the
-- daily brief and follow-ups, kept on the device so the brief works offline.
CREATE TABLE connected_digest (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Follow-ups the user dismissed ("no reply needed"), so they aren't suggested again.
CREATE TABLE follow_up_dismissed (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

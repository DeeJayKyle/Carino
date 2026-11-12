-- Phone calls through the user's own Twilio account (credentials encrypted), and the calls made.
CREATE TABLE phone_service (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_sid TEXT NOT NULL,
  secret TEXT NOT NULL,          -- encrypted auth token
  from_number TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE phone_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT,
  call_sid TEXT,
  to_number TEXT NOT NULL,
  purpose TEXT NOT NULL,
  questions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'starting',
  answers TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

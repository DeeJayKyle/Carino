-- Jobs and scholarships being applied for: eligibility, deadline, documents, referees, progress and follow-ups.
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'job',             -- job | scholarship | other
  title TEXT NOT NULL,                          -- e.g. "Pharmacist" or "Chevening Scholarship"
  organisation TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  deadline TEXT,                                -- local date
  status TEXT NOT NULL DEFAULT 'interested',    -- interested | preparing | applied | interview | offer | accepted | rejected | withdrawn
  eligible TEXT NOT NULL DEFAULT 'unsure',      -- yes | no | unsure
  eligibility TEXT NOT NULL DEFAULT '',         -- the requirements, and how the user meets them
  value TEXT NOT NULL DEFAULT '',               -- salary, stipend or award
  notes TEXT NOT NULL DEFAULT '',
  applied_on TEXT,
  next_step TEXT NOT NULL DEFAULT '',
  follow_up_on TEXT,
  deadline_reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  follow_up_reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_applications_user ON applications(user_id, status, deadline);

-- What each application needs: documents (CV, transcript), referees and other requirements.
CREATE TABLE application_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- document | referee | requirement
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needed',        -- needed | requested | ready | done
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  contact TEXT NOT NULL DEFAULT '',             -- a referee's email or phone
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_application_items ON application_items(application_id);

-- What happened, in order (status changes and notes).
CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_application_events ON application_events(application_id, created_at);

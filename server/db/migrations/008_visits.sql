-- One row per user per local ISO week they opened Carino: drives the weekly streak and
-- the specialist modes it unlocks.
CREATE TABLE visits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week TEXT NOT NULL,                          -- e.g. 2026-W44
  PRIMARY KEY (user_id, week)
);

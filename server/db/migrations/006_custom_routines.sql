-- Custom routines: a user-written instruction that Carino's agent runs on a schedule.
-- Built-in routines (morning_briefing, evening_review) leave these columns empty.
ALTER TABLE routines ADD COLUMN title TEXT;
ALTER TABLE routines ADD COLUMN prompt TEXT;
ALTER TABLE routines ADD COLUMN catalog_id TEXT;              -- the idea it was created from, if any
ALTER TABLE routines ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE routines ADD COLUMN last_result TEXT;             -- the reply from the latest run

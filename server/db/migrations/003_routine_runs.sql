-- Record the outcome of each routine run so failures are visible instead of silent.
ALTER TABLE routines ADD COLUMN last_run_at TEXT;
ALTER TABLE routines ADD COLUMN last_status TEXT;   -- ok | failed
ALTER TABLE routines ADD COLUMN last_error TEXT;

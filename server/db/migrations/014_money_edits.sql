-- Expenses can be edited safely: a version for conflict checks (existing rows keep their data).
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
UPDATE expenses SET updated_at = created_at WHERE updated_at IS NULL;

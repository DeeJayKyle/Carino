-- Routine builder: a routine can be a list of steps, and can be limited to what it may use.
ALTER TABLE routines ADD COLUMN steps TEXT;          -- JSON array of short instructions, in order (NULL: just the prompt)
ALTER TABLE routines ADD COLUMN access TEXT;         -- JSON array of access groups (NULL: everything, as before)
